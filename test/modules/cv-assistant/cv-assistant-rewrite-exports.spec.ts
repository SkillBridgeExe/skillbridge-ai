// test/modules/cv-assistant/cv-assistant-rewrite-exports.spec.ts
import { numberTokens, hasWord, NAMED_TECH } from "../../../src/modules/cv-assistant/cv-assistant-rewrite";
describe("cv-assistant gate exports (reused by cv-intake)", () => {
  it("numberTokens keeps unit + range as one token", () => {
    expect(numberTokens("30% and 1-2 years")).toEqual(["30%", "1-2years"]);
  });
  it("hasWord is whole-word", () => {
    expect(hasWord("Node.js and Kafka", "kafka")).toBe(true);
    expect(hasWord("nodemon", "node")).toBe(false);
  });
  it("NAMED_TECH includes the AI stack", () => {
    expect(NAMED_TECH).toEqual(expect.arrayContaining(["react", "node.js", "langchain"]));
  });
});
