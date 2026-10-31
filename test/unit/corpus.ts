import corpus from "../fixtures/corpus.json";

export interface Corpus {
  commit: string;
  files: Record<string, string>;
}

export function loadCorpus(): Corpus {
  return corpus as Corpus;
}
