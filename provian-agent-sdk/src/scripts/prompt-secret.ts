/**
 * readSecret - read a line of input without echoing it to the terminal.
 *
 * Used for passphrase entry. The question prompt is printed, then readline's
 * output is muted so typed characters never appear on screen or in scrollback.
 * Streams are injectable so the masking behaviour can be tested against a fake
 * terminal instead of requiring a manual smoke test on a real device.
 */
import { createInterface } from 'readline';

export function readSecret(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  return new Promise((resolve) => {
    // terminal:true forces readline to echo input through _writeToOutput, which
    // is exactly the path we mute. Without it, nothing would be echoed and the
    // masking would be untested/irrelevant.
    const rl = createInterface({ input, output, terminal: true });

    let muted = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string): void => {
      // While muted, write nothing - the typed passphrase is fully hidden.
      if (!muted) output.write(s);
    };

    rl.question(question, (answer) => {
      rl.close();
      output.write('\n');
      resolve(answer);
    });

    // rl.question() has already written the prompt synchronously above. Mute
    // now so only the prompt is visible and the subsequent keystrokes are not.
    muted = true;
  });
}
