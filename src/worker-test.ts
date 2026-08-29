import type { ContextLike } from './types';

export default {
  async fetch(request: Request, env: any, ctx: ContextLike): Promise<Response> {
    return new Response('Hello World!');
  },
};
