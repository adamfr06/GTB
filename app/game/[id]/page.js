import GameClient from "@/components/GameClient";

export default async function SharedGamePage({ params }) {
  const { id } = await params;
  return <GameClient initialGameId={id} />;
}
