// Test double for the embedding model only: hashed bag of words plus a small
// fixed synonym map, L2-normalized. Deterministic, no model, no network.

export const HASH_EMBEDDER_MODEL = "test-hash-v1";
const DIM = 512;

/** Words in one group share a concept feature. */
const CONCEPTS: string[][] = [
  ["bread", "sourdough", "starter", "leaven", "yeast", "dough", "culture", "ferment", "flour"],
  ["sail", "mainsail", "canvas", "jib", "reef", "reefing"],
  ["wind", "gale", "gust", "breeze", "knots"],
  ["shorten", "reduce", "reducing", "lower", "smaller"],
  ["tax", "taxes", "revenue", "irs", "liability", "return"],
  ["quarterly", "installment", "installments", "periodic"],
  ["freelance", "freelancer", "freelancing", "contractor", "self", "employed"],
  ["payment", "payments", "pay", "paying", "paid"],
  ["release", "releases", "drop", "dropped", "freed", "free", "deallocate"],
  ["memory", "storage", "heap"],
  ["scope", "program", "variable"],
  ["cold", "chilly", "freezing", "frost", "chill"],
  ["plants", "crops", "seedlings", "tender"],
  ["shield", "shielding", "protect", "cover"],
  ["compost", "composting", "humus", "soil", "scraps", "peelings", "leftovers", "leaves"],
  ["circle", "wheel", "ring", "clockwise"],
  ["tonalities", "keys", "key", "signature"],
  ["ear", "listening", "aural", "hearing"],
  ["intervals", "distances", "pitch", "interval"],
  ["recognise", "identify", "recognize"],
  ["rail", "train", "trains", "railway", "locomotive"],
  ["cheap", "cheaper", "budget", "pass", "passes"],
  ["countries", "country", "multi"],
  ["visa", "passport", "citizens", "entry", "enter", "tourist"],
  ["europe", "schengen", "european"],
  ["documents", "papers", "paperwork", "checklist"],
  ["boat", "yacht", "vessel", "anchor", "anchoring"],
  ["drifting", "dragging", "drift"],
  ["quarter", "quarters", "coming", "next"],
  ["retrospective", "retro"],
  ["joining", "hire", "newcomer", "teammate"],
  ["month", "thirty", "weeks"],
  ["timing", "tempo", "metronome", "beat", "rhythm"],
  ["water", "irrigation", "drip", "emitters"],
  ["slow", "slowly"],
];

const STOP = new Set(("the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get let put say she too use " +
  "about after again also been before being from have here into just more most only other over same some such than that their them then there these they this those " +
  "were what when where which while will with would your into each every").split(" "));

const conceptOf = new Map<string, number>();
CONCEPTS.forEach((group, i) => group.forEach((w) => conceptOf.set(w, i)));

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function add(vec: number[], feature: string, weight: number): void {
  const h = hash(feature);
  vec[h % DIM]! += (h & 0x80000000 ? -1 : 1) * weight;
}

export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 2 || STOP.has(word)) continue;
    add(vec, `w:${word}`, 1);
    if (word.length > 5) add(vec, `p:${word.slice(0, 5)}`, 0.5);
    const concept = conceptOf.get(word);
    if (concept !== undefined) add(vec, `c:${concept}`, 2);
  }
  const norm = Math.hypot(...vec) || 1;
  return vec.map((v) => v / norm);
}

export const hashEmbedder = {
  id: HASH_EMBEDDER_MODEL,
  embed: async (texts: string[]): Promise<number[][]> => texts.map(hashEmbed),
};
