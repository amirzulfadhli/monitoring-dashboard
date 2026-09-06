// Minimal ambient types for Node's built-in `node:sqlite` module. @types/node@20
// predates the module; the runtime ships it on Node 22.15+ (the version this
// project runs). Keep in sync with the small surface of storage.ts only.
declare module "node:sqlite" {
  export type SQLInputValue = string | number | bigint | null | Uint8Array;

  export interface RunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...anonymousParameters: SQLInputValue[]): RunResult;
    get(...anonymousParameters: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
    all(...anonymousParameters: SQLInputValue[]): Record<string, SQLInputValue>[];
  }

  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
