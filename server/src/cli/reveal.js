// One-time secrets from the command-line tools (create-tenant, create-hq-admin).
//
// A secret (a generated password or a set-password link) is written to stdout and nowhere else:
// never to the logger, never to stderr, which carries the other messages. stdout must be a
// terminal, or the operator passes --secret-to-stdout on purpose to send it into a root-only file:
//
//   sudo sh -c 'umask 077; docker compose exec -T api node src/cli/create-tenant.js ... --secret-to-stdout > /root/first-signin.txt'
//
// Run the tools with `docker compose exec` (not `run`): the output of an exec session never
// reaches the container's log driver, while a `run` container's stdout does.

/** Why the secret must not be printed here, or null when stdout is fine. */
export function secretOutputProblem({ isTTY, allowPipe }) {
  if (isTTY || allowPipe) return null;
  return 'stdout is not a terminal, so the one-time secret could land in a log or a transcript. '
    + 'Run this in an interactive terminal (docker compose exec without -T), or pass --secret-to-stdout '
    + 'and redirect stdout to a root-only file (umask 077).';
}

/** Non-secret progress for the operator. */
export function info(message) {
  process.stderr.write(`${message}\n`);
}
