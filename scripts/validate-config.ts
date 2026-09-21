import { loadConfig, ConfigError, configPath } from '../src/config.js';

function main(): void {
  try {
    const config = loadConfig();
    const enabled = Object.entries(config.tests)
      .filter(([, value]) => value)
      .map(([key]) => key);

    console.log(`Configuration file : ${configPath()}`);
    console.log(`Base URL           : ${config.baseUrl}`);
    console.log(`Credentials        : ${config.hasCredentials ? 'provided' : 'not provided (auth tests will skip)'}`);
    console.log(`Enabled test groups: ${enabled.length > 0 ? enabled.join(', ') : 'none'}`);
    console.log(`Page load budget   : ${config.options.pageLoadBudgetMs}ms`);
    console.log(`Links sampled/page : ${config.options.maxLinksToCheck}`);
    console.log(`Fail on console err: ${config.options.failOnConsoleErrors}`);

    if (enabled.length === 0) {
      console.error('\nEvery test group is disabled in config.yaml — nothing would run.');
      process.exit(1);
    }
    console.log('\nConfiguration is valid.');
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main();
