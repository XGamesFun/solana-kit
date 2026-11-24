// A tool's answer as the developer reads it in a terminal. The tools' texts are written for an AI agent that relays them
// to "the person" (the developer or project owner), and some sentences tell the agent what to ask or say. In a
// terminal the reader is that person: those sentences are said to them instead, or dropped when they only steer the
// agent. The answer's facts are the same. The MCP server and `--json` keep the agent's words (tools that read them, such
// as xcore's review, parse its "Ask the person" and "Tell the person" blocks).

/** [what the agent is told, what the person reads], in order. Each pattern names the sentence it rewrites. */
const REWORDS = [
  // (check: the questions a warning raises are listed after the warnings, in the reader's words)
  [
    /Ask the person how many players they expect and how many tickets each buys before building on it\./g,
    'How many players do you expect, and how many tickets will each buy? Settle that before you build on it.',
  ],
  [/Ask the person how many will enter and with how much\./g, 'How many will enter, and with how much?'],
  [
    /Ask the person how much they expect staked, then check again\./g,
    'Estimate how much will be staked, then check again.',
  ],
  [/Ask the person which, and build that \(skill rule 11\)\./g, 'Choose one, and build that.'],
  [
    / Ask who, and when they are available, before placing it\./g,
    ' Decide who does it, and when they are available, before you rely on it.',
  ],
  [/\bAsk who sends it and when they are available;/g, 'Decide who sends it and when they are available;'],
  [
    /Ask, and keep the caps the person gives; a cap picked for them is said as a pick, with what it means in their numbers\./g,
    'Set the caps yourself; a cap that was picked for you is only a guess, so check what it means in your numbers.',
  ],
  [
    /If you wrote the server and the page, read what each computes, and say the answer to the person in one sentence; if they run their own, ask\. /g,
    'Check what your server and page compute. ',
  ],
  [
    /, so a loop through it is not followed and the person is not told of it\./g,
    ', so a loop through it is not followed.',
  ],
  [/\bAsk, then /g, 'Once you know, '],
  // (check/decisions, contests, schedules)
  [/Tell the person who decides it and how they pick the wallet;/g, 'Say who decides it and how they pick the wallet;'],
  [/Tell the person it is off and what it waits for,/g, 'Say on the page that it is off and what it waits for,'],
  [
    /, run xsolana[_ ]review, and tell the person what a cheater gets\./g,
    ', and run xsolana review to see what a cheater gets.',
  ],
  [
    /Tell the person, as xsolana[_ ]check’s “The law” line puts it, once now and again before mainnet; show the odds on the page, and get a lawyer before real money\./g,
    'Read the legal note in this check; show the odds on the page, and get a lawyer before real money.',
  ],
  [
    /Tell the person, as xsolana[_ ]check’s “The law” line puts it, once now and again before mainnet: before real money they need a lawyer and an age and region gate\./g,
    'Read the legal note in this check: before real money you need a lawyer and an age and region gate.',
  ],
  // (review)
  [/ Then tell the person which, and what a cheater gets\./g, ''],
  [/Pick one, and tell the person the trade-off: /g, 'Pick one: '],
  [/^Trade-offs to show the person$/gm, 'Trade-offs'],
  // (guide)
  [/xsolana examples <the person’s own words>/g, 'xsolana examples <your idea, in a few words>'],
  [/ when the person’s wants pull against each other;/g, ' when your goals pull against each other;'],
  [/ when the person says to put it live\./g, ' when you are ready to put it live.'],
  [
    / A choice or a question the tools leave for the person comes before anything is saved: saving a spec is building, a draft too\./g,
    ' Settle the choices and questions the tools raise before you build on a saved spec.',
  ],
  // (explain)
  [/, which your agent is told to do only after your yes\./g, ', which you do once you have read it.'],
  [
    /: tell the person as each is agreed, not only in a last checklist; when a new fact reopens a settled choice, say what changed and why\./g,
    '.',
  ],
];

/** `text` (a tool's answer, already in a terminal's words) as the person reads it. */
export function personWords(text) {
  let out = String(text);
  for (const [from, to] of REWORDS) out = out.replace(from, to);
  return out;
}

/** Words that only an agent's text uses: a person's text holds none of them (js/test/cli-output.test.mjs). */
export const AGENT_ONLY =
  /\b(the person|your own words|Ask, then|tell them|ask them|your pick|end your turn|skill rule)\b/i;
