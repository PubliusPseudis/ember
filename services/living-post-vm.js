// services/living-post-vm.js 
import Interpreter from 'js-interpreter';

const GAS_LIMIT = 5000000; // Max number of steps

export class LivingPostManager {
    constructor() {
        this.vmCache = new Map();
    }

    // This function sets up the API available inside the sandbox
initApi(interpreter, globalObject) {
    // Wrapper for setState(stateObject)
    const setState = interpreter.createNativeFunction(function(stateObject) {
        try {
            // 1. Convert the object from the sandbox into a real JavaScript object.
            const nativeObject = interpreter.pseudoToNative(stateObject);
            // 2. Convert that real JavaScript object into a JSON string.
            const newStateJson = JSON.stringify(nativeObject);
            // 3. Store the new state string.
            interpreter.setProperty(globalObject, '__newState', interpreter.nativeToPseudo(newStateJson));
        } catch (e) {
            console.error("LP setState Error:", e);
        }
    });
    interpreter.setProperty(globalObject, 'setState', setState);

    // Wrapper for getState()
    const getState = interpreter.createNativeFunction(function() {
        return interpreter.getProperty(globalObject, '__currentState');
    });
    interpreter.setProperty(globalObject, 'getState', getState);

    // Wrapper for getInteraction()
    const getInteraction = interpreter.createNativeFunction(function() {
        return interpreter.getProperty(globalObject, '__interaction');
    });
    interpreter.setProperty(globalObject, 'getInteraction', getInteraction);
    
    // Wrapper for log()
    const log = interpreter.createNativeFunction(function(text) {
        console.log(`[LP LOG]:`, text.toString());
    });
    interpreter.setProperty(globalObject, 'log', log);
}

    run(postId, code, functionName, currentState, interaction = null) {
        console.log('[LivingPostManager RUN] Executing...', {
            postId: postId,
            functionName: functionName,
            code: code,
            currentState: currentState,
            interaction: interaction
        });
        return new Promise((resolve, reject) => {
            try {
                // Use a NEW interpreter for every run to ensure a clean state
                const vm = new Interpreter(code, this.initApi);

                // Set the context for this specific run
                vm.setProperty(vm.globalObject, '__currentState', vm.nativeToPseudo(JSON.parse(currentState)));
                vm.setProperty(vm.globalObject, '__interaction', vm.nativeToPseudo(interaction));
                vm.setProperty(vm.globalObject, '__newState', vm.nativeToPseudo(null));

                // Find and run the target function
                const functionCall = `${functionName}();`;
                vm.appendCode(functionCall);

                let steps = 0;
                while (steps < GAS_LIMIT && vm.step()) {
                    steps++;
                }

                if (steps >= GAS_LIMIT) {
                    return reject(new Error('Execution limit exceeded (infinite loop?)'));
                }

                const newStatePseudo = vm.getProperty(vm.globalObject, '__newState');
                const newState = vm.pseudoToNative(newStatePseudo);
                
                resolve(newState || currentState);

            } catch (e) {
                reject(e);
            }
        });
    }
}
