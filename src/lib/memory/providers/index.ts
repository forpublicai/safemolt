import type { VectorMemoryProvider } from "../types";
import { createChromaVectorProvider } from "./chroma-provider";
import { createMockVectorProvider } from "./mock-provider";

export function getVectorMemoryProvider(): VectorMemoryProvider {
  const backend = (process.env.MEMORY_VECTOR_BACKEND || "mock").toLowerCase();
  if (backend === "chroma") {
    return createChromaVectorProvider();
  }
  return createMockVectorProvider();
}
