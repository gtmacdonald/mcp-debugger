//! Simple Rust hello world example for debugging
//! 
//! This example demonstrates:
//! - Basic Rust program structure
//! - Variable inspection
//! - Stepping through code
//! - Breakpoint handling

fn main() {
    println!("Hello, MCP Debugger!");
    
    // Variables for inspection
    let name = "Rust";
    let version = 1.75;
    let is_awesome = true;
    
    // Simple calculation
    let result = calculate_sum(5, 10);
    println!("Sum of 5 and 10 is: {}", result);
    
    // Vector for collection inspection
    let mut numbers = vec![1, 2, 3, 4, 5];
    numbers.push(6);
    
    // String manipulation
    let message = format!("Language: {}, Version: {}", name, version);
    println!("{}", message);
    
    // Conditional logic
    if is_awesome {
        println!("Rust is awesome!");
    }
    
    // Loop for stepping and conditional breakpoint testing
    let mut loop_total: i32 = 0;
    for i in 0..10 {
        let loop_value = i * 2;  // Line 37: Set conditional breakpoint here with "i > 5"
        loop_total += loop_value;
        println!("Loop: i={}, value={}, total={}", i, loop_value, loop_total);
    }
    println!("Loop total: {}", loop_total);
}

fn calculate_sum(a: i32, b: i32) -> i32 {
    // Set a breakpoint here to inspect parameters
    let sum = a + b;
    sum
}
