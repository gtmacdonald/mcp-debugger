const std = @import("std");

pub fn main() !void {
    var x: i32 = 10;
    var y: i32 = 20;

    // Mutate to avoid "never mutated" error
    x += 1;
    y += 1;

    const z = x + y;

    std.debug.print("Hello, world! x={d}, y={d}, z={d}\n", .{ x, y, z });

    var i: usize = 0;
    while (i < 5) : (i += 1) {
        std.debug.print("Loop iteration: {d}\n", .{i});
    }
}
