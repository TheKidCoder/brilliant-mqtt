import { Client } from 'ssh2';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Shell {
  exec(command: string, stdin?: Buffer | string): Promise<ExecResult>;
  close(): void;
}

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Expected SHA-256 host-key fingerprint (base64, as `ssh-keygen -lf` prints). */
  hostKeySha256?: string;
  onHostKey?: (fingerprint: string) => void;
}

/**
 * Password-only SSH (Brilliant's Root SSH has no authorized-keys mechanism).
 * One auth attempt only, so a wrong password fails fast instead of risking a
 * lockout.
 */
export function connect(target: SshTarget): Promise<Shell> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    client.on('ready', () => {
      settled = true;
      resolve({
        exec: (command, stdin) => exec(client, command, stdin),
        close: () => client.end(),
      });
    });
    client.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSH to ${target.host} failed: ${error.message}`));
      }
    });
    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      tryKeyboard: false,
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      hostHash: 'sha256',
      hostVerifier: (hash: string) => {
        const fingerprint = Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '');
        target.onHostKey?.(fingerprint);
        if (!target.hostKeySha256) {
          return true;
        }
        return target.hostKeySha256.replace(/^SHA256:/, '').replace(/=+$/, '') === fingerprint;
      },
      authHandler: ['password'],
    });
  });
}

function exec(client: Client, command: string, stdin?: Buffer | string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
      stream.on('error', reject);
      stream.end(stdin);
    });
  });
}

/** Run a command and throw with the remote stderr when it fails. */
export async function run(shell: Shell, command: string, stdin?: Buffer | string): Promise<string> {
  const result = await shell.exec(command, stdin);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`remote command failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}
