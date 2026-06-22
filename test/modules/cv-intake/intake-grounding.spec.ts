// test/modules/cv-intake/intake-grounding.spec.ts
import { isGrounded } from "../../../src/modules/cv-intake/intake-grounding";
const N = "Tôi làm ở SmartAI Solutions vị trí AI Engineer, xây chatbot bằng GPT-4o, giảm 40% thời gian.";
describe("isGrounded", () => {
  it("accepts a value present in the narrative", () => {
    expect(isGrounded("SmartAI Solutions", N)).toBe(true);
    expect(isGrounded("GPT-4o", N)).toBe(true);
    expect(isGrounded("giảm 40% thời gian", N)).toBe(true);
  });
  it("rejects a fabricated entity not in the narrative", () => {
    expect(isGrounded("Google", N)).toBe(false);
  });
  it("rejects a fabricated number", () => {
    expect(isGrounded("giảm 80% thời gian", N)).toBe(false); // 80% not stated (40% is)
  });
  it("rejects a fabricated named-tech (Kafka)", () => {
    expect(isGrounded("xây bằng Kafka", N)).toBe(false);
  });
});
