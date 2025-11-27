const std = @import("std");

pub fn main() !void {
    var x: i32 = 10;
    var y: i32 = 20;

    // Mutate to avoid "never mutated" error
    x += 1;
    y += 1;

    const z = x + y;

    std.debug.print("Hello, world! x={d}, y={d}, z={d}\n", .{ x, y, z });

    // Loop for conditional breakpoint testing
    // When using condition "i > 5", should only stop when i=6,7,8,9
    var total: usize = 0;
    var i: usize = 0;
    while (i < 10) : (i += 1) {
        const value = i * 2;  // Line 20: Set conditional breakpoint here
        total += value;
        std.debug.print("i={d}, value={d}, total={d}\n", .{ i, value, total });
    }
    std.debug.print("Final total: {d}\n", .{total});
}
