export interface Config {
  capPerMinute: number;
  capPerDay: number;
  sectionSplitChars: number;
  responseCharCap: number;
  staleAfterHours: number;
  publicOrigin: string;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readConfig(env: Env): Config {
  return {
    capPerMinute: num(env.CAP_PER_MINUTE, 300),
    capPerDay: num(env.CAP_PER_DAY, 30000),
    sectionSplitChars: num(env.SECTION_SPLIT_CHARS, 6000),
    responseCharCap: num(env.RESPONSE_CHAR_CAP, 32000),
    staleAfterHours: num(env.STALE_AFTER_HOURS, 72),
    publicOrigin: env.PUBLIC_ORIGIN,
  };
}
