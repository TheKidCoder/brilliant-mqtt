import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, run } from '../src/cli/ssh.js';

const { Server, utils } = ssh2;

/** A password-only SSH server that runs each exec request through local sh. */
describe('ssh transport', () => {
  const keys = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(keys.public);
  if (parsed instanceof Error) {
    throw parsed;
  }
  const fingerprint = createHash('sha256')
    .update(parsed.getPublicSSH())
    .digest('base64')
    .replace(/=+$/, '');
  let attempts = 0;
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        attempts += 1;
        if (ctx.username === 'root' && ctx.password === 's3cret "pw"') {
          ctx.accept();
          return;
        }
      }
      ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            let code = 0;
            try {
              stream.write(execFileSync('sh', ['-c', info.command], { input: Buffer.concat(chunks) }));
            } catch (error) {
              const failure = error as { status?: number; stderr?: Buffer };
              code = failure.status ?? 1;
              stream.stderr.write(failure.stderr ?? '');
            }
            stream.exit(code);
            stream.end();
          });
        });
      });
    });
    client.on('error', () => undefined);
  });
  let port = 0;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as AddressInfo).port;
          resolve();
        });
      }),
  );
  afterAll(() => {
    server.close();
  });

  const target = (overrides: object = {}) => ({
    host: '127.0.0.1',
    port,
    username: 'root',
    password: 's3cret "pw"',
    ...overrides,
  });

  it('authenticates by password, streams stdin and returns output', async () => {
    let seen = '';
    const shell = await connect(target({ onHostKey: (value: string) => (seen = value) }));
    try {
      expect(seen).toBe(fingerprint);
      const payload = Buffer.alloc(300_000, 'x');
      expect((await run(shell, 'wc -c', payload)).trim()).toBe('300000');
      expect(await run(shell, 'set -e\necho one\necho two')).toBe('one\ntwo\n');
    } finally {
      shell.close();
    }
  });

  it('reports the exit code and stderr of a failing command', async () => {
    const shell = await connect(target());
    try {
      await expect(run(shell, 'echo nope >&2; exit 23')).rejects.toThrow(/exit 23.*nope/);
    } finally {
      shell.close();
    }
  });

  it('tries a wrong password exactly once', async () => {
    attempts = 0;
    await expect(connect(target({ password: 'wrong' }))).rejects.toThrow(/SSH to 127.0.0.1 failed/);
    expect(attempts).toBe(1);
  });

  it('refuses a host whose key does not match the pin', async () => {
    await expect(connect(target({ hostKeySha256: 'SHA256:AAAA' }))).rejects.toThrow(/failed/);
    const shell = await connect(target({ hostKeySha256: `SHA256:${fingerprint}` }));
    shell.close();
  });
});
