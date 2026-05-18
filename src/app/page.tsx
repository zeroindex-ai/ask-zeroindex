import { AskWidget } from '@/components/AskWidget';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 md:py-16">
      <header className="mb-8">
        <p className="label mb-3">Ask</p>
        <h1 className="text-2xl font-semibold tracking-tight text-white">ask-zeroindex</h1>
        <p className="mt-2 text-sm text-white">
          Questions about services, pricing, process, or background — answered from this site&apos;s content
          with citations.
        </p>
      </header>

      <AskWidget />
    </main>
  );
}
