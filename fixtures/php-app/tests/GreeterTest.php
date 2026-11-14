<?php

declare(strict_types=1);

namespace Fixture\Tests;

use Fixture\Greeter;
use PHPUnit\Framework\TestCase;

final class GreeterTest extends TestCase
{
    public function testGreetsByName(): void
    {
        self::assertSame('Olá, Ana!', (new Greeter())->greet(' Ana '));
    }

    public function testFallsBackToWorld(): void
    {
        self::assertSame('Olá, mundo!', (new Greeter())->greet('  '));
    }
}
