// Simple loop for testing conditional breakpoints
// When using condition "i > 5", should only stop when i=6,7,8,9

function main() {
    let total = 0;
    for (let i = 0; i < 10; i++) {
        const value = i * 2;  // Line 7: Set conditional breakpoint here
        total += value;
        console.log(`i=${i}, value=${value}, total=${total}`);
    }

    console.log(`Final total: ${total}`);
    return total;
}

main();
