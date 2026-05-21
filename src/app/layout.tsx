import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ask · ZeroIndex',
  description:
    "RAG chat for zeroindex.ai — ask anything about ZeroIndex's services, principles, and process, answered with citations.",
  metadataBase: new URL(process.env.PUBLIC_BASE_URL ?? 'https://ask.zeroindex.ai'),
  openGraph: {
    title: 'Ask · ZeroIndex',
    description: 'Ask anything about ZeroIndex — grounded answers with sources from the site.',
    url: '/',
    siteName: 'ZeroIndex',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* /favicon.ico is auto-served + auto-linked by Next.js from app/favicon.ico */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="48x48" href="/favicon-48x48.png" />
        <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png" />
        <link rel="apple-touch-icon" href="/favicon-180x180.png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
