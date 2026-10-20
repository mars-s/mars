import type { Metadata } from "next";
import { DesignSystem } from "./design-system";

export const metadata: Metadata = { title: "Mars · Design system" };

export default function DesignSystemPage() {
  return <DesignSystem />;
}
