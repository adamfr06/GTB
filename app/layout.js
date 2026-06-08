import "./globals.css";

export const metadata = {
  title: "GTB",
  description: "Minecraft block 20 questions"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
