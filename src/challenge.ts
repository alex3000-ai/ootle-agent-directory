// Anti-spam "verification challenges": an obfuscated word-math problem an LLM agent can solve
// easily but a dumb script cannot. Content stays hidden until the agent answers via POST /verify.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function words(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}

function rand(min: number, max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[rand(0, arr.length - 1)];
}

const NOISE = ["^", "~", "]", "[", "/", "*", "-", "|"];

// Randomly mangles casing and sprinkles junk symbols, like "a VaL]iDa-ToR".
function obfuscate(text: string): string {
  let out = "";
  for (const ch of text) {
    out += rand(0, 1) ? ch.toUpperCase() : ch.toLowerCase();
    if (/[a-z]/i.test(ch) && rand(0, 11) === 0) out += pick(NOISE);
  }
  return out;
}

interface Template {
  build(a: number, b: number): { text: string; answer: number };
}

const TEMPLATES: Template[] = [
  { build: (a, b) => ({ text: `an ootle validator holds ${words(a)} tari and is sent ${words(b)} more. how many tari does it hold now?`, answer: a + b }) },
  { build: (a, b) => ({ text: `a shard commits ${words(a)} transactions per block for ${words(b % 9 + 2)} blocks. how many transactions in total?`, answer: a * (b % 9 + 2) }) },
  { build: (a, b) => ({ text: `a wallet has ${words(a + b)} tari and pays a fee of ${words(b)} tari. how much is left?`, answer: a }) },
  { build: (a, b) => ({ text: `${words(a)} agents each mint ${words(b % 9 + 2)} nfts. how many nfts were minted?`, answer: a * (b % 9 + 2) }) },
  { build: (a, b) => ({ text: `a committee of ${words(a)} nodes gains ${words(b)} nodes then loses ${words(Math.min(a, b) % 10)}. how many nodes remain?`, answer: a + b - (Math.min(a, b) % 10) }) },
];

export function makeChallenge(): { question: string; answer: string } {
  const { text, answer } = pick(TEMPLATES).build(rand(3, 60), rand(2, 40));
  return { question: obfuscate(text), answer: answer.toFixed(2) };
}
