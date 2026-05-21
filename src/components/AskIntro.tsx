// Single source for the Ask section copy. Rendered on both the standalone
// page (dark ink on cream) and the embed iframe (light on the .ask-surface
// dark background) — colors come from the surrounding surface tokens, so the
// same markup themes itself to either context. Moving this copy here is what
// lets ask.zeroindex.ai own the heading instead of the marketing HTML.

export const ASK_COPY = {
  label: 'Ask',
  heading: 'Ask anything.',
  // ask.zeroindex.ai is its own subdomain, so it names the source site
  // explicitly — answers are grounded in zeroindex.ai's content, not "this
  // site". (The embed renders inside zeroindex.ai and gets its heading + the
  // "this site" copy from the marketing HTML, not this component.)
  intro: "Answers are grounded in zeroindex.ai's content, with sources cited.",
};

// Standalone page only. Heading sized to match intake-zero's section header
// (text-3xl md:text-4xl + text-base intro).
export function AskIntro() {
  return (
    <header>
      <p className="label mb-3">{ASK_COPY.label}</p>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{ASK_COPY.heading}</h1>
      <p className="mt-4 muted text-base leading-relaxed max-w-4xl">{ASK_COPY.intro}</p>
    </header>
  );
}
