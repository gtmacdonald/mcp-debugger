// Simple loop for testing conditional breakpoints
// When using condition "i > 5", should only stop when i=6,7,8,9

fn main() {
    let mut total: i32 = 0;
    for i in 0..10 {
        let value = i * 2;  // Line 8: Set conditional breakpoint here
        total += value;
        println!("i={}, value={}, total={}", i, value, total);
    }

    println!("Final total: {}", total);
}
