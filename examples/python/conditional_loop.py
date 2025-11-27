# Simple loop for testing conditional breakpoints
# When using condition "i > 5", should only stop when i=6,7,8,9

def main():
    total = 0
    for i in range(10):
        value = i * 2  # Line 7: Set conditional breakpoint here
        total += value
        print(f"i={i}, value={value}, total={total}")

    print(f"Final total: {total}")
    return total

if __name__ == "__main__":
    result = main()
