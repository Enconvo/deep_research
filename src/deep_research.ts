import { deepResearch, writeFinalReport } from './deep-research';
import { generateFeedback } from './feedback';
import { Action, BaseChatMessage, ChatMessageContent, LLMProvider, LLMTool, RequestOptions, res, Response, ResponseAction } from '@enconvo/api';
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

  const initialQuery = options.topic || options.input_text;
  if (!initialQuery) {
    throw new Error('Please provide a topic for me to research');
  }


  // Get breath and depth parameters
  const breadth = options.breadth || 1;
  const depth = options.depth || 1;

  const systemMessage = BaseChatMessage.system(systemPrompt());
  const userMessage = BaseChatMessage.user(initialQuery);


  const clarifyWithTextToolSchema = z.object({
    query: z.string().describe('The query to clarify'),
  })
  const clarifyWithTextToolSchemaJson = zodToJsonSchema(clarifyWithTextToolSchema)

  let clarifyMessage: BaseChatMessage | undefined;

  const clarifyWithTextTool: LLMTool = {
    name: 'clarify_with_text',
    description: 'Clarify the research direction',
    hide: true,
    end: true,
    parameters: clarifyWithTextToolSchemaJson,
    toolType: 'method',
    run: async ({ query, flowId }: { query: string, flowId: string }) => {
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

  let researchResult: BaseChatMessage | undefined;
  const startResearchTool: LLMTool = {
    name: 'start_research',
    title: 'Deep Research',
    description: 'Start a research task',
    notUseToolContent: true,
    parameters: startResearchToolSchemaJson,
    toolType: 'method',
    end: true,
    run: async ({ query, flowId }: { query: string, flowId: string }) => {
      console.log(`\n\nStarting research for ${query} with flowId ${flowId}`);

      let messageContentArray: ChatMessageContent[] = [];
      const { learnings, visitedUrls } = await deepResearch({
        query: query,
        breadth,
        depth,
        flowId,
        messageContentArray,
      });

      console.log(`\n\nVisited URLs (${visitedUrls.length}):\n\n${visitedUrls.join('\n')}`);
      console.log('Writing final report...');
      res.writeLoading("🔍 Writing final report", flowId);

      const report = await writeFinalReport({
        prompt: query,
        learnings,
        visitedUrls,
      });

      res.write({
        content: `✅ Final report has been generated`,
        action: res.WriteAction.FlowAppendToLastMessageContent,
        flowId,
      })

      // Save report to file

      researchResult = report;
      return BaseChatMessage.assistant(messageContentArray)
    }
  };

  const llm = await LLMProvider.fromEnv();
  const stream = await llm.stream({
    messages: [systemMessage, ...(options.history_messages || []), userMessage],
    tools: [clarifyWithTextTool, startResearchTool]
  })

  console.log("researchResult", stream)

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

    // @ts-ignore
    researchResult?.content?.unshift(...stream.content)

    return Response.messages([researchResult!], actions)
  }


  actions = [
    Action.Paste({ content: stream.text() }),
    Action.Copy({ content: stream.text() }),
  ]


  return Response.messages([stream], actions)

}

