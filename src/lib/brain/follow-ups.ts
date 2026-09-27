// WEDJAT BRAIN — Follow-up Question Generator
//
// After each answer, the Brain suggests 3 related questions the user might
// want to ask next. This creates a conversational guide that helps users
// explore topics deeper — like how ChatGPT suggests follow-ups.

import type { RetrievalCandidate, EvidenceRef, TraceStep } from "./types";

export interface FollowUpSuggestion {
  question: string;
  intent: "deeper" | "broader" | "related" | "practical" | "verify";
  rationale: string;
}

/**
 * Generate follow-up question suggestions based on the answer, evidence,
 * and trace. Uses heuristics to identify natural next questions.
 */
export function generateFollowUps(opts: {
  question: string;
  answer: string;
  evidence: EvidenceRef[];
  candidates: RetrievalCandidate[];
  taskType: string;
  domain?: string;
}): FollowUpSuggestion[] {
  const { question, answer, evidence, candidates, taskType, domain } = opts;
  const suggestions: FollowUpSuggestion[] = [];
  const q = question.toLowerCase().trim();

  // 1. Deeper: ask for more detail on the same topic
  if (answer.length > 200) {
    const keyTerms = extractKeyTerms(answer);
    if (keyTerms.length > 0) {
      suggestions.push({
        question: `Can you explain ${keyTerms[0]} in more detail?`,
        intent: "deeper",
        rationale: `Dive deeper into "${keyTerms[0]}" mentioned in the answer`,
      });
    }
  }

  // 2. Broader: ask about the broader context/category
  if (domain && domain !== "default") {
    const broaderQuestions: Record<string, string> = {
      math: "What are the practical applications of this mathematical concept?",
      physics: "How was this discovered and what are its real-world implications?",
      chemistry: "What are the industrial or everyday applications of this?",
      biology: "How does this relate to human health or disease?",
      history: "What were the long-term consequences of this event?",
      "cs-theory": "Where is this used in real software systems?",
      programming: "Can you show a code example of this?",
      philosophy: "How does this philosophical concept apply to modern life?",
      literature: "What is the historical context of this work?",
      medicine: "What are the common treatments or prevention strategies?",
      law: "How does this legal principle apply in practice?",
      economics: "What are the real-world economic implications?",
      geography: "What is the cultural and political significance of this region?",
      language: "How does this linguistic concept affect communication?",
      engineering: "What are the practical engineering applications?",
    };
    if (broaderQuestions[domain]) {
      suggestions.push({
        question: broaderQuestions[domain],
        intent: "broader",
        rationale: `Explore the broader implications in the ${domain} domain`,
      });
    }
  }

  // 3. Related: ask about something mentioned in the evidence but not in the answer
  const unusedEvidence = evidence.filter((e) => {
    const claimLower = e.claim.toLowerCase();
    const answerLower = answer.toLowerCase().slice(0, 500);
    return !answerLower.includes(claimLower.slice(0, 30));
  });
  if (unusedEvidence.length > 0) {
    const claim = unusedEvidence[0].claim;
    // Convert the claim into a question
    const followUpQ = claim.endsWith(".")
      ? `Tell me more about: ${claim.slice(0, -1).toLowerCase()}`
      : `What can you tell me about ${claim.toLowerCase().slice(0, 80)}?`;
    suggestions.push({
      question: followUpQ,
      intent: "related",
      rationale: "Related evidence was found but not fully explored in the answer",
    });
  }

  // 4. Practical: "How do I use/apply this?"
  if (taskType === "factual" || taskType === "reasoning") {
    suggestions.push({
      question: `How can I apply this in practice?`,
      intent: "practical",
      rationale: "Bridge from theory to practical application",
    });
  }

  // 5. Verify: "What are the counterarguments or limitations?"
  if (taskType === "reasoning" || taskType === "synthesis") {
    suggestions.push({
      question: `What are the limitations or counterarguments to this?`,
      intent: "verify",
      rationale: "Critical thinking — explore opposing views or limitations",
    });
  }

  // Deduplicate and return top 3
  const seen = new Set<string>();
  const unique = suggestions.filter((s) => {
    const key = s.question.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, 3);
}

/**
 * Extract key terms from an answer (nouns, technical terms, names).
 */
function extractKeyTerms(text: string): string[] {
  // Simple heuristic: find capitalized words or technical terms
  const terms: string[] = [];

  // Find capitalized multi-word phrases (likely proper nouns or concepts)
  const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
  if (properNouns) {
    terms.push(...properNouns.filter((t) => t.length > 3 && !["The", "This", "That", "When", "What", "How", "Why", "Which", "According"].includes(t)));
  }

  // Find technical terms (words with specific patterns)
  const technical = text.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g); // camelCase
  if (technical) terms.push(...technical);

  // Find terms in quotes
  const quoted = text.match(/"([^"]{3,40})"/g);
  if (quoted) terms.push(...quoted.map((q) => q.replace(/"/g, "")));

  // Find bold terms (**term**)
  const bold = text.match(/\*\*([^*]{3,40})\*\*/g);
  if (bold) terms.push(...bold.map((b) => b.replace(/\*\*/g, "")));

  return [...new Set(terms)].slice(0, 5);
}
