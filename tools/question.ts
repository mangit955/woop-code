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

    try {
      // Create question prompt for user
      const questionPrompt = createQuestionPrompt(validQuestions);
      
      // Request answers from user via UI
      const answers = await requestUserAnswers(questionPrompt, validQuestions);

      // Format response
      return formatQuestionResponse(validQuestions, answers);
    } catch (error) {
      if (error instanceof Error && error.message === "User cancelled") {
        return "User cancelled the questions. You can:\n- Proceed without the information\n- Ask different questions\n- Simplify your approach";
      }
      throw error;
    }
  },
};

function createQuestionPrompt(questions: string[]): string {
  const lines = ["I need some information from you:\n"];

  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question}`);
  });

  lines.push("\nPlease answer each question.");

  return lines.join("\n");
}

async function requestUserAnswers(
  prompt: string,
  questions: string[]
): Promise<string[]> {
  // Create a pending question request
  const questionRequest = {
    id: crypto.randomUUID(),
    prompt,
    questions,
    answers: [] as string[],
  };

  // Add system message to timeline showing the questions
  store.addSystemMessage(prompt);

  // For now, we'll use a simple promise-based approach
  // In a full implementation, this would integrate with the UI store
  // to show a question dialog and wait for user input
  
  return new Promise((resolve, reject) => {
    // Simulated answer collection
    // In production, this would:
    // 1. Show a question dialog in the UI
    // 2. Collect user input for each question
    // 3. Return the answers
    
    // For now, return placeholder indicating manual input needed
    const placeholderAnswers = questions.map(
      () => "[User input required - please respond in chat]"
    );
    
    setTimeout(() => {
      resolve(placeholderAnswers);
    }, 100);
  });
}

function formatQuestionResponse(
  questions: string[],
  answers: string[]
): string {
  const lines = [
    `I asked you ${questions.length} question${questions.length !== 1 ? "s" : ""}:\n`,
  ];

  questions.forEach((question, index) => {
    const answer = answers[index] || "Unanswered";
    lines.push(`Q: ${question}`);
    lines.push(`A: ${answer}\n`);
  });

  lines.push(
    "I will now continue with your answers in mind."
  );

  return lines.join("\n");
}
