import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';

function safe(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return 'unavailable';
  }
}

function main(): void {
  const config = loadConfig();

  console.log('Prepared test environment');
  console.log('-------------------------');
  console.log(`Node.js        : ${process.version}`);
  console.log(`Platform       : ${process.platform} ${process.arch}`);
  console.log(`Playwright     : ${safe('npx', ['playwright', '--version'])}`);
  console.log(`Target base URL: ${config.baseUrl}`);
  console.log(`Credentials    : ${config.hasCredentials ? 'provided' : 'not provided'}`);
  console.log('Browsers       : chromium, webkit');
}

main();
