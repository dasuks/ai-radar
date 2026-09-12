import * as init from "./0001_init.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** 버전 오름차순. 새 migration 은 배열 끝에 추가한다 (CONTRACTS_AND_DATA.md §7.4). */
export const MIGRATIONS: readonly Migration[] = [
  { version: init.version, name: init.name, sql: init.sql },
];
