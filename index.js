const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const gameTableName = process.env.GAME_TABLE;
const connectionsTableName = process.env.CONNECTIONS_TABLE;
const apiGatewayManagementApi = new AWS.ApiGatewayManagementApi({
    endpoint: process.env.WEBSOCKET_ENDPOINT
});

exports.handler = async (event) => {
    const { gameId, playerId } = JSON.parse(event.body);
    const connectionId = event.requestContext.connectionId;

    try {
        const game = await getGameState(gameId);
        if (!game) {
            console.error(`Game with ID ${gameId} not found`);
            throw new Error('Game not found');
        }

        if (game.gameStage === 'gameOver') {
            throw new Error("The game is over. No more actions allowed.");
        }

        const playerIndex = game.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || game.players[playerIndex].position !== game.currentTurn) {
            throw new Error(`It's not this player's turn or the player ID ${playerId} not found in game ${gameId}`);
        }

        const { actionSuccessful, updatedPlayers, updatedPot } = callBet(playerId, game.players, game.pot, game.highestBet);

        if (!actionSuccessful) {
            throw new Error("Call action was not successful.");
        }

        game.players = updatedPlayers;
        game.pot = updatedPot;
        game.players[playerIndex].hasActed = true;

        const allInConditionMet = checkAllInCondition(game);
        if (!allInConditionMet) {
            if (allPlayersHaveActed(game)) {
                await advanceGameStage(game); // This should include saving the updated game state and notifying players
            } else {
                await advanceTurn(game); // This should include saving the updated game state and notifying players
            }
        }

        // Send the updated game state to all connected clients
        await notifyAllPlayers(gameId, game);
        
        return { statusCode: 200, body: 'Call action processed.' };
    } catch (error) {
        console.error('Error processing playerCall:', error);
        // Optionally, send an error message back to the caller
        await apiGatewayManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({ error: error.message })
        }).promise();

        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    }
};

async function getGameState(gameId) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
    };
    const { Item } = await dynamoDb.get(params).promise();
    return Item;
}