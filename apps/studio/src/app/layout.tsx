import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cadmus Studio",
  description: "Live timeline + processor inspector for a Cadmus agent.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
