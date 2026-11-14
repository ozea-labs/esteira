<?php

declare(strict_types=1);

namespace Fixture;

final class Greeter
{
    public function greet(string $name): string
    {
        return sprintf('Olá, %s!', '' === trim($name) ? 'mundo' : trim($name));
    }
}
