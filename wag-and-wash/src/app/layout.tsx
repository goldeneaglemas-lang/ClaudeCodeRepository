import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wag & Wash",
  description: "Book a grooming appointment with Jess at Wag & Wash.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            Wag &amp; Wash
          </Link>
          <nav aria-label="Main">
            <Link href="/book">Book</Link>
            <Link href="/my-bookings">My bookings</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
