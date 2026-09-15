import './styles.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Overflow — Programmable Earnings',
  description: 'Keep the source. Program the earnings.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
