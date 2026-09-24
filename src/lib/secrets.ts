/**
 * The environment variables that carry a DevPulse credential.
 *
 * DevPulse spawns a few short-lived child processes (the Windows toast helper
 * and the PowerShell probes for local security, storage and network sampling).
 * Every one of them runs a fixed script that has no use for either credential,
 * and Node inherits the parent environment into a child by default — so they are
 * removed explicitly at each spawn site.
 *
 * This is defence in depth, not a closed hole: no child is given a credential
 * in argv, none of their scripts read the environment for a secret, and none of
 * their output is served. Removing the values means a child process cannot see
 * them at all.
 */

/** Credential variables DevPulse reads, in one place. */
export const CREDENTIAL_ENV_VARS = ["GITHUB_TOKEN", "DEEPSEEK_API_KEY"] as const;

/**
 * A copy of `env` with the credential variables removed. Everything else — PATH,
 * SystemRoot, TEMP, locale — is preserved, because the children still need it.
 */
export function withoutCredentials(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of CREDENTIAL_ENV_VARS) delete copy[name];
  return copy;
}
