import { AskWidget } from '@/components/AskWidget';
import { AskIntro } from '@/components/AskIntro';

export default function Home() {
  // Mirrors intake-zero exactly: intro section pt-10 pb-8, content section pb-24,
  // and the card matches intake's form container — rounded-2xl, p-8 md:p-10,
  // max-w-4xl left-aligned, no border (the dark fill alone defines the edge).
  // .ask-surface keeps the warm near-black Ask color instead of intake's --card.
  return (
    <>
      <section className="pt-10 pb-8">
        <AskIntro />
      </section>
      <section className="pb-24">
        <div className="ask-surface flex flex-col rounded-2xl p-8 md:p-10 max-w-4xl w-full min-h-[480px]">
          <AskWidget showFooterCredits={false} />
        </div>
      </section>
    </>
  );
}
