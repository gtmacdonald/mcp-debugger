const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "zig-harness",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    b.installArtifact(exe);

    // On macOS, create dSYM bundle for debugging support
    // Zig doesn't automatically run dsymutil, so we add it as a custom step
    // Run with: zig build dsym
    if (target.result.os.tag == .macos) {
        const dsymutil_step = b.addSystemCommand(&.{
            "dsymutil",
            b.getInstallPath(.bin, "zig-harness"),
            "-o",
            b.getInstallPath(.bin, "zig-harness.dSYM"),
        });
        dsymutil_step.step.dependOn(b.getInstallStep());

        const dsym_step = b.step("dsym", "Create dSYM bundle for debugging");
        dsym_step.dependOn(&dsymutil_step.step);
    }
}
