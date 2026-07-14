// Root layout — wraps every route in the app tree. The navbar lives
// here so it persists across navigation between sibling pages (/,
// /visualizer, etc.) instead of re-rendering each time. Tailwind v4 is
// imported via globals.css; importing CSS in the root layout makes its
// utilities available everywhere.

import './globals.css';
import { Navbar } from '@/components/navbar';

export const metadata = {
  title: 'sched-linx',
  description: 'DLX-based scheduling backend',
};

const NAV_ROUTES = [
  { title: 'Home', path: '/' },
  { title: 'Scenarios', path: '/scenarios' },
  { title: 'Agentic onboarding', path: '/agentic-onboarding' },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex flex-row space-x-4">
          <Navbar routes={NAV_ROUTES} orientation='vertical'/>
          <div className="container py-4 width-full">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
