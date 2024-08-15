const _ = {
  set: (obj, path = '', value) => {
    let pointer = obj;
    path.split('.').forEach((key, index, arr) => {
      if (key === '__proto__' || key === 'constructor') return;

      if (index === arr.length - 1) {
        pointer[key] = value;
      } else if (!(key in pointer) || typeof pointer[key] !== 'object') {
        pointer[key] = {};
      }

      pointer = pointer[key];
    });
  },
  get: (obj, path, defaultValue) => {
    const travel = (regexp) =>
      String.prototype.split
        .call(path, regexp)
        .filter(Boolean)
        .reduce(
          // @ts-expect-error implicit any on res[key]
          (res, key) => (res !== null && res !== undefined ? res[key] : res),
          obj,
        );
    const result = travel(/[,[\]]+?/) || travel(/[,.[\]]+?/);
    return result === undefined || result === obj ? defaultValue : result;
  },
};

import {
  defer,
  EMPTY,
  from,
  of,
  concatMap,
  filter,
  publish,
  reduce,
  isObservable,
} from 'rxjs';
import runAsync from 'run-async';
import * as utils from '../utils/utils.js';
import Base from './baseUI.js';

/**
 * Base interface class other can inherits from
 */
export default class PromptUI extends Base {
  constructor(prompts, opt) {
    super(opt);
    this.prompts = prompts;
  }

  run(questions, answers) {
    // Keep global reference to the answers
    this.answers = typeof answers === 'object' ? { ...answers } : {};

    let obs;
    if (Array.isArray(questions)) {
      obs = from(questions);
    } else if (isObservable(questions)) {
      obs = questions;
    } else if (
      Object.values(questions).every(
        (maybeQuestion) =>
          typeof maybeQuestion === 'object' &&
          !Array.isArray(maybeQuestion) &&
          maybeQuestion != null,
      )
    ) {
      // Case: Called with a set of { name: question }
      obs = from(
        Object.entries(questions).map(([name, question]) => ({
          name,
          ...question,
        })),
      );
    } else {
      // Case: Called with a single question config
      obs = from([questions]);
    }

    this.process = obs.pipe(
      concatMap(this.processQuestion.bind(this)),
      publish(), // Creates a hot Observable. It prevents duplicating prompts.
    );

    this.process.connect();

    return this.process
      .pipe(
        reduce((answersObj, answer) => {
          _.set(answersObj, answer.name, answer.answer);
          return answersObj;
        }, this.answers),
      )
      .toPromise(Promise)
      .then(this.onCompletion.bind(this), this.onError.bind(this));
  }

  /**
   * Once all prompt are over
   */
  onCompletion() {
    this.close();

    return this.answers;
  }

  onError(error) {
    this.close();
    return Promise.reject(error);
  }

  processQuestion(question) {
    question = { ...question };
    return defer(() => {
      const obs = of(question);

      return obs.pipe(
        concatMap(this.setDefaultType.bind(this)),
        concatMap(this.filterIfRunnable.bind(this)),
        concatMap(() =>
          utils.fetchAsyncQuestionProperty(question, 'message', this.answers),
        ),
        concatMap(() =>
          utils.fetchAsyncQuestionProperty(question, 'default', this.answers),
        ),
        concatMap(() =>
          utils.fetchAsyncQuestionProperty(question, 'choices', this.answers),
        ),
        concatMap(this.fetchAnswer.bind(this)),
      );
    });
  }

  fetchAnswer(question) {
    const Prompt = this.prompts[question.type];
    this.activePrompt = new Prompt(question, this.rl, this.answers);
    return defer(() =>
      from(this.activePrompt.run().then((answer) => ({ name: question.name, answer }))),
    );
  }

  setDefaultType(question) {
    // Default type to input
    if (!this.prompts[question.type]) {
      question.type = 'input';
    }

    return defer(() => of(question));
  }

  filterIfRunnable(question) {
    if (
      question.askAnswered !== true &&
      _.get(this.answers, question.name) !== undefined
    ) {
      return EMPTY;
    }

    if (question.when === false) {
      return EMPTY;
    }

    if (typeof question.when !== 'function') {
      return of(question);
    }

    const { answers } = this;
    return defer(() =>
      from(
        runAsync(question.when)(answers).then((shouldRun) => {
          if (shouldRun) {
            return question;
          }
        }),
      ).pipe(filter((val) => val != null)),
    );
  }
}
