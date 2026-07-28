import type { Tool } from "../config/types";
import { store } from "../tui/src/store/ui-store";

export const questionTool: Tool = {
  name: "ask_user",
  description: `Ask the user questions to gather information needed to complete their request.

Use this when you need:
- Clarification on ambiguous requests
- Additional details or preferences
- User confirmation before proceeding
- Input that only the user can provide

You can ask multiple questions at once. Each question will be presented to the user,
and their answers will be returned to you.

Examples:
- "Which API endpoint should I modify?"
- "Do you want to use TypeScript or JavaScript?"
- "Should I update the tests as well?"`,

  parameters: [
    {
      name: "questions",
      description: "Array of questions to ask the user (e.g., ['What is the API key?', 'Which environment?'])",
      required: true,
      type: "array",
    },
  ],

  async execute(args) {
    const questions = args.questions as string[];

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      throw new Error("At least one question is required");
    }

    // Validate questions
    const validQuestions = questions.filter(
      (q) => typeof q === "string" && q.trim().length > 0
    );

    if (validQuestions.length === 0) {
      throw new Error("All questions are empty");
    }

    if (validQuestions.length > 10) {
      throw new Error("Maximum 10 questions allowed at once");
    }

    const answers = await requestUserAnswers(validQuestions);
    if (answers === null) {
      return "The user declined to answer these questions. Do not assume an answer; explain the blocker or ask a narrower question.";
    }
    return formatQuestionResponse(validQuestions, answers);
  },
};

async function requestUserAnswers(
  questions: string[]
): Promise<string[] | null> {
  return store.setPendingQuestion({
    id: crypto.randomUUID(),
    questions,
  });
}

function formatQuestionResponse(
  questions: string[],
  answers: string[]
): string {
  const lines = [
    `User answers to ${questions.length} question${questions.length !== 1 ? "s" : ""}:\n`,
  ];

  questions.forEach((question, index) => {
    const answer = answers[index] || "Unanswered";
    lines.push(`Q: ${question}`);
    lines.push(`A: ${answer}\n`);
  });

  lines.push("Use these answers as the user's stated preferences.");

  return lines.join("\n");
}
