import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wag & Wash",
  description: "Book a grooming appointment with Jess at Wag & Wash.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
