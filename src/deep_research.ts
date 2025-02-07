import { deepResearch, writeFinalReport } from './deep-research';
import { generateFeedback } from './feedback';
import { Action, BaseChatMessage, LLMProvider, LLMTool, RequestOptions, Response, ResponseAction } from '@enconvo/api';
import { systemPrompt } from './prompt';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';


interface DeepResearchOptions extends RequestOptions {
  topic?: string;
  breadth?: number;
  depth?: number;
}

// run the agent
export default async function main(req: Request) {
  const options: DeepResearchOptions = await req.json();

  console.log("options", options)

  const initialQuery = options.topic || options.input_text;
  if (!initialQuery) {
    throw new Error('Please provide a topic for me to research');
  }

  // Get breath and depth parameters
  const breadth = options.breadth || 4;
  const depth = options.depth || 2;

  console.log(`Creating research plan...`);

  const systemMessage = BaseChatMessage.system(systemPrompt());
  const userMessage = BaseChatMessage.user(initialQuery);



  const clarifyWithTextToolSchema = z.object({
    query: z.string().describe('The query to clarify'),
  })
  const clarifyWithTextToolSchemaJson = zodToJsonSchema(clarifyWithTextToolSchema)
  console.log(clarifyWithTextToolSchemaJson)

  let clarifyMessage: BaseChatMessage | undefined;

  const clarifyWithTextTool: LLMTool = {
    name: 'clarify_with_text',
    description: 'Clarify the research direction',
    hide: true,
    end: true,
    parameters: clarifyWithTextToolSchemaJson,
    toolType: 'method',
    run: async ({ query }: { query: string }) => {
      console.log(`Clarifying research for ${query}`);
      const followUpQuestions = await generateFeedback({
        query: query,
      });

      clarifyMessage = followUpQuestions;

      return followUpQuestions;
    }
  };

  const startResearchToolSchema = z.object({
    query: z.string().describe('The topic with additional details to research'),
  })
  const startResearchToolSchemaJson = zodToJsonSchema(startResearchToolSchema)
  console.log(startResearchToolSchemaJson)

  let researchResult: BaseChatMessage | undefined;
  const startResearchTool: LLMTool = {
    name: 'start_research',
    title: 'Deep Research',
    description: 'Start a research task',
    parameters: startResearchToolSchemaJson,
    toolType: 'method',
    end: true,
    run: async ({ query }: { query: string }) => {
      console.log(`Starting research for ${query}`);

      console.log('\nResearching your topic...');

      const { learnings, visitedUrls } = await deepResearch({
        query: query,
        breadth,
        depth,
      });

      console.log(`\n\nLearnings:\n\n${learnings.join('\n')}`);
      console.log(`\n\nVisited URLs (${visitedUrls.length}):\n\n${visitedUrls.join('\n')}`);
      console.log('Writing final report...');

      const report = await writeFinalReport({
        prompt: query,
        learnings,
        visitedUrls,
      });

      // Save report to file

      console.log(`\n\nFinal Report:\n\n${report.text()}`);
      console.log('\nReport has been saved to output.md');
      researchResult = report;
      return report;
    }
  };

  const llm = await LLMProvider.fromEnv();
  const stream = await llm.stream({
    messages: [systemMessage, ...(options.history_messages || []), userMessage],
    tools: [clarifyWithTextTool, startResearchTool]
  })

  console.log("researchResult", researchResult)

  let actions: ResponseAction[] = []

  if (researchResult) {
    actions = [
      Action.Paste({ content: researchResult.text() }),
      Action.Copy({ content: researchResult.text() }),
      Action.SaveAsFile({
        fileName: 'output.md',
        content: researchResult.text()
      })
    ]
  }

  return Response.messages([stream], actions)

}

