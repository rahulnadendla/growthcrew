import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GrowthCrew — an AI growth team for every startup",
  description: "Paste your product page. A team of AI agents researches, writes ads in English, Hindi and Telugu, plans the test and learns from results.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
