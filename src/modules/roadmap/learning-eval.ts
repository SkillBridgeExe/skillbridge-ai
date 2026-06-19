/**
 * Learning-chatbot eval scorer (deterministic, no LLM), aligned to the RAGAS metric framework:
 *  - context_recall  : retrieval quality — did the retriever surface the gold resources?
 *                      |gold ∩ retrieved| / |gold| (1 when there is no gold, e.g. a no-resource case).
 *  - grounded        : faithfulness proxy — every cited resource_id is in the retrieved set (no fabrication).
 *  - cited_match     : the cited set equals the expected set (given what was retrieved).
 *  - honest_empty    : when nothing should be cited, the answer cites nothing (honest empty-state).
 *  - pass            : answer quality = grounded && cited_match && honest_empty (separate from retrieval recall).
 *
 * The LLM-dependent RAGAS dimensions (claim-level faithfulness, answer_relevancy) need the real answer and
 * are computed once RAG-PR2 ships — see the TODO in the harness. context_recall here evaluates the RETRIEVER
 * independently of the answer, exactly the RAGAS retrieval/generation split.
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
  /** Ground-truth ideal resources for the query, independent of what was retrieved (for context_recall). */
  gold_resource_ids: string[];
  /** What a correct answer should cite GIVEN the retrieved set ([] = honest empty-state). */
  expected_cited_resource_ids: string[];
  expected_behavior: string;
}

export interface LearningAnswer {
  message: string;
  cited_resource_ids: string[];
}

export interface LearningEvalResult {
  id: string;
  context_recall: number;
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
  const context_recall =
    c.gold_resource_ids.length === 0
      ? 1
      : c.gold_resource_ids.filter((id) => retrieved.has(id)).length / c.gold_resource_ids.length;
  const grounded = answer.cited_resource_ids.every((id) => retrieved.has(id));
  const cited_match = sameSet(answer.cited_resource_ids, c.expected_cited_resource_ids);
  const honest_empty =
    c.expected_cited_resource_ids.length > 0 ? true : answer.cited_resource_ids.length === 0;
  return {
    id: c.id,
    context_recall,
    grounded,
    cited_match,
    honest_empty,
    pass: grounded && cited_match && honest_empty,
  };
}
