Feature: Searching for assets on the DKG
  Background: Setup local blockchain, bootstraps and nodes
    Given the blockchain is set up
    And 1 bootstrap is running

  Scenario: Search assertion on the network with keywords
    Given I setup 4 nodes
    When I call search request on node 1 with result type assertions for the keywords:
      | keyword 1 | keyword 2 |
    And I wait for last search request to finalize
    Then The result of assertion search cannot be 0
    And The search result should contain all valid data
    And Metadata from last search request contains the keywords:
      | keyword 1 | keyword 2 |
    And The number of nodes that responded cannot be 0


