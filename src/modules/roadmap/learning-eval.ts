/**
 * Learning-chatbot eval scorer (deterministic, no LLM). Given a golden case + a produced answer,
 * checks the three properties that matter for a grounded learning assistant:
 *  - grounded: every cited resource_id is in the retrieved set (no fabrication);
 *  - cited_match: the cited set equals the expected set;
 *  - honest_empty: when no resource is expected, the answer cites nothing (honest empty-state).
 * The real chatbot's answer plugs into `scoreLearningCase` once RAG-PR2 ships; until then the harness
 * runs each case against its own expected citations to prove the golden set is self-consistent.
 */

export interface LearningEvalResource {
  resource_id: string;
  title: string;
  source_type: string;
  low_confidence?: boolean;
}

export interface LearningEvalCase {
  id: string;
  category: string;
  user_question: string;
  context: {
    gaps?: { skill: string; severity: number; status: string }[];
    role?: string;
    days_available?: number;
  };
  retrieved_resources: LearningEvalResource[];
  expected_cited_resource_ids: string[];
  expected_behavior: string;
}

export interface LearningAnswer {
  message: string;
  cited_resource_ids: string[];
}

export interface LearningEvalResult {
  id: string;
  grounded: boolean;
  cited_match: boolean;
  honest_empty: boolean;
  pass: boolean;
}

const sameSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
};

export function scoreLearningCase(c: LearningEvalCase, answer: LearningAnswer): LearningEvalResult {
  const retrieved = new Set(c.retrieved_resources.map((r) => r.resource_id));
  const grounded = answer.cited_resource_ids.every((id) => retrieved.has(id));
  const cited_match = sameSet(answer.cited_resource_ids, c.expected_cited_resource_ids);
  const honest_empty =
    c.expected_cited_resource_ids.length > 0 ? true : answer.cited_resource_ids.length === 0;
  return {
    id: c.id,
    grounded,
    cited_match,
    honest_empty,
    pass: grounded && cited_match && honest_empty,
  };
}
