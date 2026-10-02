# Contributing to FlowPlan

Thank you for your interest in contributing to FlowPlan.

FlowPlan is an open-source project-management application focused on 
authenticated multi-organization workspaces, projects, Kanban workflows, 
tasks, project membership, activity history, and threaded comments.

## Before contributing

Please:

1. Read the README and understand the project architecture.
2. Check existing issues and pull requests.
3. Keep pull requests focused on one logical change.
4. Avoid committing secrets, credentials, local databases, or generated
   private data.
5. Add or update tests when changing application behavior.

## Development

FlowPlan consists of a Next.js frontend and a NestJS backend backed by 
PostgreSQL and Prisma.

Changes that affect authentication, authorization, project membership, 
organization boundaries, or data access should receive particular attention 
during development and review.

## Pull requests

A pull request should:

- Explain what changed.
- Explain why the change is needed.
- Include relevant tests or validation.
- Update documentation when necessary.
- Avoid unrelated refactoring.
- Identify any database or migration changes.

For authorization-sensitive changes, describe the affected access-control 
boundary and the expected behavior for unauthorized users.

## Issues

Bug reports should include:

- A clear description of the problem.
- Steps to reproduce it.
- Expected behavior.
- Actual behavior.
- Relevant environment information.
- Logs or error messages with secrets and private information removed.

Feature requests should describe the underlying problem and proposed behavior.

## Security

Do not publicly report security vulnerabilities through normal GitHub 
issues. Follow the process described in `SECURITY.md`.

## License

By contributing to FlowPlan, you agree that your contributions will be 
licensed under the MIT License.
