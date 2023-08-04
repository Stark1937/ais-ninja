import {getLogger} from "../utils/logger";
import {Transform, TransformCallback} from "stream";
import {OpenAIClient} from "./openai";
import {AnthropicClient} from "./anthropic";
import {StabilityClient} from "./stability";
import {SupplierClient} from "./SupplierClient";
import {Token} from "../models/Token";
import ApiProxy from "./ApiProxy";
import {
  ApiClient,
  Caller,
  DefaultDataHandler,
  DefaultStopHandler,
  FinishHandler,
  Message,
  MessageHandler,
  MixModel,
  PartMessage,
} from "./types";


const logger = getLogger("ai");

export let supplierClientAgent: SupplierClientAgent;

export function initClients() {
  if (!supplierClientAgent) {
    supplierClientAgent = new SupplierClientAgent();
  }
}

export class SupplierClientAgent {

  private supplierClients = new Map<string, SupplierClient<ApiClient>>;

  constructor() {
    this.supplierClients.set(AnthropicClient.SUPPLIER, new AnthropicClient());
    this.supplierClients.set(OpenAIClient.SUPPLIER, new OpenAIClient());
    this.supplierClients.set(StabilityClient.SUPPLIER, new StabilityClient());
    this.supplierClients.forEach((supplierClient) => {
      supplierClient.initClients().then(() => {
        logger.info(`${supplierClient.supplier} clients initialized`);
      }).catch((err) => {
        logger.error(`${supplierClient.supplier} clients initialization failed: ` + err);
      });
    })
  }

  putClient(token: Token) {
    this.supplierClients.get(token.supplier!)!.putClient(token);
  }

  removeClient(token: Token) {
    this.supplierClients.get(token.supplier!)!.removeClient(token.id);
  }

  getClient(supplier: string, id: number): [Token, ApiClient] {
    return this.supplierClients.get(supplier)!.getClient(id);
  }

  getRandomClient(model: string): [Token, ApiProxy<ApiClient>];
  getRandomClient(model: string, user_id: number): [Token, ApiProxy<ApiClient>];
  getRandomClient(model: string, caller: Caller): [Token, ApiProxy<ApiClient>];
  getRandomClient(model: string, caller?: Caller | number): [Token, ApiProxy<ApiClient>] {
    let supplierClient = this.getSupplierClient(model);
    if (!supplierClient) {
      throw new Error(`No ${model} client provide.`);
    }
    return supplierClient.getRandomClient(model, caller ? typeof caller === 'number' ? {user_id: caller} : caller : {});
  }

  getSupplierClient(model: string): SupplierClient<ApiClient> | undefined {
    if (['claude', 'anthropic'].some(prefix => model.startsWith(prefix))) {
      return this.supplierClients.get(AnthropicClient.SUPPLIER);
    } else if (['gpt', 'text', 'code', 'dall', 'openai'].some(prefix => model.startsWith(prefix))) {
      return this.supplierClients.get(OpenAIClient.SUPPLIER);
    } else if (['stable', 'stability'].some(prefix => model.startsWith(prefix))) {
      return this.supplierClients.get(StabilityClient.SUPPLIER);
    } else {
      throw new Error(`No ${model} client provide.`);
    }
  }

  async listModels(): Promise<MixModel[]> {
    const mixModels: MixModel[] = [];
    for (const supplier of ['openai', 'anthropic', 'stability']) {
      try {
        await this.getRandomClient(supplier)[1].listModels(true).then((models) => {
          mixModels.push(...models);
        }).catch();
      } catch (e) {
      }
    }
    return mixModels;
  }
}

export class Chat {
  protected user_id?: number;
  protected readonly options: any;
  protected messages: Message[] = [];
  protected readonly res: any;
  protected readonly parentMessageId: string;
  protected finishedHandlers: FinishHandler[] = [];

  constructor(res: any, options: any, parentMessageId: string, historyMessages: Message[] = []) {
    this.res = res;
    this.options = options;
    this.parentMessageId = parentMessageId;
    this.messages = historyMessages;
  }

  add_finish_handler(handler: FinishHandler) {
    this.finishedHandlers.push(handler);
    return this;
  }

  set_user_id(user_id: number) {
    this.user_id = user_id;
    return this;
  }

  /**
   * Convert messages to custom format
   * @param messages
   */
  convert_custom(messages: Message[] = this.messages): any {
    return [];
  }

  /**
   * Convert messages to supplier format
   * @param supplier_messages
   */
  convert_supplier(supplier_messages: any[]): Message[] {
    return [];
  }

  async chat(message: Message): Promise<void> {
    this.messages.push(message);
  }

  stop_handler: MessageHandler<Message> = (completeMessage: Message[] | Message, callback?: any) => {
    if (logger.isLevelEnabled('debug'))
      logger.debug(`Complete data：${JSON.stringify(completeMessage)}`);

    this.messages.push(...(Array.isArray(completeMessage) ? completeMessage : [completeMessage])
      .filter((message) => {
        return message.content && message.content.length > 0;
      })
    );
    if (this.finishedHandlers.length > 0) {
      this.finishedHandlers.forEach((handler) => {
        handler(this.messages, this.options.model);
      });
    }
    callback && callback();
  }

  res_error(error: any) {
    this.res_write({
      parentMessageId: this.parentMessageId,
      role: 'assistant',
      segment: 'error',
      content: error.message || error.toString(),
    });
  }

  res_write<T extends Message>(message: T) {
    if (this.res.finished || !message) return
    if (!this.res.headersSent) {
      this.res.setHeader('Content-Type', 'text/event-stream;charset=utf-8');
    }
    let text = JSON.stringify(message);
    if (logger.isLevelEnabled('debug')) {
      logger.debug(`Send user data：${text}`);
    }
    this.res.write(`\n\n${text}\n\n`);
  }
}

export class ChatTransform<T extends Message> extends Transform {
  protected readonly dataHandler: MessageHandler<PartMessage>;
  protected readonly stopHandler: MessageHandler<Message>;
  protected completed_message: T = {content: ''} as T
  protected stop = false;
  protected caches: string = '';
  protected function_call = false;

  constructor(dataHandler: MessageHandler<PartMessage> = DefaultDataHandler,
              stopHandler: MessageHandler<Message> = DefaultStopHandler) {
    super({objectMode: true});
    this.dataHandler = dataHandler;
    this.stopHandler = stopHandler;
  }

  parse(data: string): any | null {
    let message: any = null;
    try {
      message = JSON.parse(data);
    } catch (e) {
      if (this.caches !== '') {
        try {
          this.caches = this.caches + data;
          message = JSON.parse(this.caches);
          this.caches = '';
        } catch (e) {
          return;
        }
      } else {
        this.caches = data;
        return;
      }
    }
    return message;
  }

  part(message: T) {
    message.role && (this.completed_message.role = message.role);
    message.content && (this.completed_message.content += message.content);
  }

  async part_end(messages: PartMessage[], callback: TransformCallback) {
    let is_callback = false;

    if (messages.length > 0 && !this.function_call) {
      await this.dataHandler(messages, callback);
      is_callback = true;
    }

    if (this.stop) {
      await this.stopHandler(this.completed_message, is_callback ? undefined : callback);
      is_callback = true;
    }

    !is_callback && callback();
  }

  _destroy(error: Error | null, callback: (error: (Error | null)) => void) {
    super._destroy(error, callback);
  }
}

