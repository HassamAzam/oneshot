/**
 * Imported FIRST by tests whose output names the project. config.ts reads
 * GITLAB_REPO_URL once, at load, so it has to be set before anything imports
 * config — and set rather than inherited, so this machine's .env cannot change
 * the answer (dotenv never overrides a key that is already set).
 */
process.env.GITLAB_REPO_URL = 'https://gitlab.example.com/acme/erp';
