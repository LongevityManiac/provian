import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const catalog = JSON.parse(readFileSync(resolve(root, 'provian-backend/src/core/notifications/locales/en.json'), 'utf8'));
export function expressionCopy(node) {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map((span, index) => `{{value${index}}}` + span.literal.text).join('')];
  if (ts.isConditionalExpression(node)) return [...expressionCopy(node.whenTrue), ...expressionCopy(node.whenFalse)];
  return [];
}
export function pushSourceCopy(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const copy = [];
  const visit = node => {
    if (ts.isCallExpression(node) && /(?:^|\.)(sendPush|sendPushToUser)$/.test(node.expression.getText(source))) {
      for (const arg of node.arguments) if (ts.isObjectLiteralExpression(arg)) {
        for (const property of arg.properties) if (ts.isPropertyAssignment(property) && ['title','body'].includes(property.name.getText(source))) copy.push(...expressionCopy(property.initializer));
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'pushToCounterparty') copy.push(...expressionCopy(node.arguments[4]), ...expressionCopy(node.arguments[5]));
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'PUSH_TITLES' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) if (ts.isPropertyAssignment(property)) copy.push(...expressionCopy(property.initializer));
    }
    // The promise close-out message is selected before entering its shared send helper.
    if (file.endsWith('routes/human-promises.ts') && ts.isVariableDeclaration(node) && node.name.getText(source) === 'body') copy.push(...expressionCopy(node.initializer));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return copy;
}
const files = ['server.ts','routes/agent-invite.ts','routes/human-promises.ts','core/commons/job-notify.ts','core/commons/threads.ts','core/commons/forum.ts','core/pe/presentation-request-store.ts','core/pe/human-approval-request-store.ts'];
const known = new Set(Object.values(catalog));
let evaluated = 0;
for (const file of files) {
  for (const text of pushSourceCopy(readFileSync(resolve(root, 'provian-backend/src', file), 'utf8'), file)) {
    evaluated++;
    if (!known.has(text)) throw new Error(`untranslated push at ${file}: ${text}`);
  }
}
if (evaluated < 40) throw new Error(`push copy population unexpectedly small: ${evaluated}`);
const planted = pushSourceCopy("sendPush(tokens, {title: 'A new untranslated notification', body: 'Open the job in Provian to see it.'})", 'control.ts');
if (!planted.some(text => !known.has(text))) throw new Error('push-copy negative control survived');
console.log(`push-copy: ${evaluated} actual source templates covered; planted untranslated notification refused`);
